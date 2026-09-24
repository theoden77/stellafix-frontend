#!/usr/bin/env python3
"""GeoNames cities1000 dökümünden ülke başına /cities/<CC>.json üretir.

Kaynak (CC BY 4.0, https://www.geonames.org/):
  - https://download.geonames.org/export/dump/cities1000.zip
  - https://download.geonames.org/export/dump/admin1CodesASCII.txt

Sadece stdlib kullanır - geonamescache/pycountry/unidecode gibi üçüncü
parti yaklaşıklık kütüphaneleri BİLEREK kullanılmıyor; asciiname, bölge
adı ve alternatenames doğrudan GeoNames'in kendi dökümünden okunuyor.

Kayıt formatı (her ülke dosyasında "cities" dizisinin her elemanı):
  [ad, asciiname (ad ile aynıysa ""), enlem(4 ondalık), boylam(4 ondalık),
   IANA tz, nüfus(binde), admin1kodu, [Latin-alfabeli alternatif adlar]]

alternatif adlar sadece nüfusu POP_THRESHOLD_FOR_ALTNAMES üzerindeki
şehirler için dolduruluyor, aksi halde boş dizi.
"""
import gzip
import io
import json
import os
import sys
import tempfile
import unicodedata
import urllib.request
import zipfile

CITIES_URL = "https://download.geonames.org/export/dump/cities1000.zip"
ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
OUTPUT_DIR = "cities"
MAX_GZIP_BYTES = 300 * 1024
POP_THRESHOLD_FOR_ALTNAMES = 100_000
REQUEST_TIMEOUT = 120


def download(url):
    print(f"İndiriliyor: {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "stellafix-frontend build script"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def load_admin1_names(admin1_txt_bytes):
    """'US.CA\tCalifornia\tCalifornia\t5332921' -> {'US.CA': 'California'}"""
    names = {}
    for line in admin1_txt_bytes.decode("utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        code, name = parts[0], parts[1]
        names[code] = name
    return names


def is_latin_only(s):
    for ch in s:
        if ch.isspace() or ch in "-'.,()/":
            continue
        try:
            uname = unicodedata.name(ch)
        except ValueError:
            return False
        if not (uname.startswith("LATIN") or ch.isdigit()):
            return False
    return True


# GeoNames cities1000.txt sütun sırası (resmi export formatı):
# 0 geonameid, 1 name, 2 asciiname, 3 alternatenames, 4 latitude, 5 longitude,
# 6 feature class, 7 feature code, 8 country code, 9 cc2, 10 admin1 code,
# 11 admin2 code, 12 admin3 code, 13 admin4 code, 14 population, 15 elevation,
# 16 dem, 17 timezone, 18 modification date
def parse_cities(cities_txt_bytes):
    for line in cities_txt_bytes.decode("utf-8").splitlines():
        if not line.strip():
            continue
        f = line.split("\t")
        if len(f) < 19:
            continue
        yield {
            "name": f[1],
            "asciiname": f[2],
            "alternatenames": [a for a in f[3].split(",") if a],
            "latitude": float(f[4]),
            "longitude": float(f[5]),
            "country_code": f[8],
            "admin1_code": f[10],
            "population": int(f[14]) if f[14] else 0,
            "timezone": f[17],
        }


def gzip_size(obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9) as gz:
        gz.write(s)
    return len(buf.getvalue())


def build_country_files(rows, admin1_names):
    by_country = {}
    for r in rows:
        cc = r["country_code"]
        if not cc:
            continue  # ülke kodu boş olan (çok nadir) kayıtlar atlanır
        by_country.setdefault(cc, []).append(r)

    country_data = {}
    for cc, recs in by_country.items():
        used_admin1 = {}
        cities = []
        for r in recs:
            name = r["name"]
            asciiname = r["asciiname"] if r["asciiname"] != name else ""
            alt_names = []
            if r["population"] > POP_THRESHOLD_FOR_ALTNAMES:
                seen = {name.lower(), r["asciiname"].lower()}
                for a in r["alternatenames"]:
                    al = a.lower()
                    if is_latin_only(a) and al not in seen:
                        alt_names.append(a)
                        seen.add(al)
            a1_code = r["admin1_code"]
            if a1_code:
                key = f"{cc}.{a1_code}"
                if a1_code not in used_admin1:
                    used_admin1[a1_code] = admin1_names.get(key, a1_code)
            cities.append([
                name,
                asciiname,
                round(r["latitude"], 4),
                round(r["longitude"], 4),
                r["timezone"],
                round(r["population"] / 1000),
                a1_code,
                alt_names,
            ])
        country_data[cc] = {"admin1": used_admin1, "cities": cities}
    return country_data


def main():
    with tempfile.TemporaryDirectory() as tmp:
        cities_zip_path = os.path.join(tmp, "cities1000.zip")
        with open(cities_zip_path, "wb") as f:
            f.write(download(CITIES_URL))
        with zipfile.ZipFile(cities_zip_path) as zf:
            cities_txt_bytes = zf.read("cities1000.txt")
        # zip dosyası tempfile.TemporaryDirectory ile birlikte otomatik silinir,
        # repoya hiçbir aşamada yazılmıyor/commit edilmiyor.

        admin1_txt_bytes = download(ADMIN1_URL)

    admin1_names = load_admin1_names(admin1_txt_bytes)
    rows = list(parse_cities(cities_txt_bytes))
    print(f"Toplam kayıt: {len(rows)}", file=sys.stderr)

    country_data = build_country_files(rows, admin1_names)

    report = []
    for cc, data in sorted(country_data.items()):
        gz = gzip_size(data)
        report.append((cc, len(data["cities"]), gz))
    report.sort(key=lambda x: -x[2])

    violations = [r for r in report if r[2] > MAX_GZIP_BYTES]

    lines = ["# Şehir veritabanı build raporu", ""]
    lines.append(f"Toplam ülke: {len(report)}, toplam kayıt: {len(rows)}")
    lines.append("")
    lines.append("En büyük 20 ülke dosyası:")
    lines.append("")
    lines.append("| Ülke | Kayıt | gzip |")
    lines.append("|---|---|---|")
    for cc, n, gz in report[:20]:
        flag = " ⚠️" if gz > MAX_GZIP_BYTES else ""
        lines.append(f"| {cc} | {n} | {gz/1024:.1f} KB{flag} |")
    report_md = "\n".join(lines) + "\n"
    print(report_md, file=sys.stderr)

    report_path = os.environ.get("BUILD_REPORT_PATH", "/tmp/cities_build_report.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_md)

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(report_md)

    if violations:
        print(f"HATA: {len(violations)} ülke dosyası {MAX_GZIP_BYTES/1024:.0f}KB gzip sınırını aşıyor:", file=sys.stderr)
        for cc, n, gz in violations:
            print(f"  {cc}: {gz/1024:.1f}KB ({n} kayıt)", file=sys.stderr)
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    index = []
    for cc, data in sorted(country_data.items()):
        with open(os.path.join(OUTPUT_DIR, f"{cc}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        index.append([cc, len(data["cities"])])
    with open(os.path.join(OUTPUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Yazıldı: {OUTPUT_DIR}/ altında {len(country_data)} ülke dosyası + index.json", file=sys.stderr)


if __name__ == "__main__":
    main()
