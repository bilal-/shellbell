#!/usr/bin/env python3
"""Validate selected asset sizes and package store files for manual upload."""
import html
import json
import struct
import zipfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
PLAN = json.loads((APP / '.listing-kit/listing.json').read_text())
OUT = APP / 'output/listing-kit'
OUT.mkdir(parents=True, exist_ok=True)


def check_png(path, width, height):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'Not PNG: {path.name}'
    actual_width, actual_height, depth, color = struct.unpack('>IIBB', data[16:26])
    assert (actual_width, actual_height, depth, color) == (width, height, 8, 2), (
        f'{path.name}: expected {width}x{height}, 8-bit RGB without alpha; '
        f'got {actual_width}x{actual_height}, depth {depth}, color type {color}'
    )


def files_for(target):
    family = target['family']
    if family.startswith('iphone') or family == 'ipad':
        folder = APP / 'fastlane/screenshots/en-US'
        suffix = '_' + target.get('filenameSuffix', family)
    else:
        folder = APP / 'fastlane/metadata/android/en-US/images' / {
            'android-phone': 'phoneScreenshots',
            'android-tablet': 'tenInchScreenshots',
        }[family]
        suffix = ''
    return [folder / f"{screen['order']:02d}_{screen['id']}{suffix}.png" for screen in PLAN['screens']]


apple_groups = []
for target in PLAN['targets']:
    files = files_for(target)
    for path in files:
        check_png(path, target['width'], target['height'])
    if target['family'].startswith('iphone') or target['family'] == 'ipad':
        apple_groups.append((target, files))

headers = []
for asset in PLAN['appleHeaders']['assets']:
    path = APP / asset['path']
    check_png(path, asset['width'], asset['height'])
    headers.append((asset, path))


def image_link(path, label):
    relative = html.escape(path.relative_to(APP).as_posix(), quote=True)
    return f'<a href="{relative}"><img src="{relative}" alt="{html.escape(label, quote=True)}" loading="lazy"><span>{html.escape(path.name)}</span></a>'


sections = []
for target, files in apple_groups:
    label = target.get('storeSlot', 'iPad 13-inch')
    images = ''.join(image_link(path, screen['altText']) for path, screen in zip(files, PLAN['screens']))
    sections.append(f'<section><h2>{html.escape(label)}</h2><p>{target["width"]} × {target["height"]} pixels · {len(files)} screenshots</p><div class="shots">{images}</div></section>')
header_images = ''.join(f'<figure>{image_link(path, PLAN["appleHeaders"]["altText"])}<figcaption>{asset["width"]} × {asset["height"]} pixels</figcaption></figure>' for asset, path in headers)
sections.append(f'<section><h2>Header Asset</h2><p>Choose one header for the Header Asset slot. These are creative assets, separate from the screenshots.</p><div class="headers">{header_images}</div></section>')
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shellbell · Apple upload assets</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#151719;color:#f6f4ef}main{max-width:1440px;margin:auto;padding:40px 24px}h1{font-size:36px;margin:0}h2{font-size:24px;margin-bottom:0}p{color:#c8c9ca}section{margin-top:48px}a{color:#f6bc4a;text-decoration:none}img{display:block;width:100%;height:auto;border-radius:12px}span{display:block;font-size:12px;margin-top:8px;overflow-wrap:anywhere}.shots{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px}.headers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}figure{margin:0}figcaption{color:#c8c9ca;font-size:14px}@media(max-width:800px){.shots{grid-template-columns:repeat(2,minmax(0,1fr))}.headers{grid-template-columns:1fr}}
</style><main><h1>Shellbell · Apple upload assets</h1><p>Match each set to the exact App Store Connect slot below. All files are 8-bit RGB PNGs without transparency.</p><p><a href="listing-review.html">Store copy and complete listing review</a></p>'''
(APP / 'apple-assets-review.html').write_text(page + ''.join(sections) + '</main></html>\n')

instructions = '''Shellbell Apple upload assets (English US)

Dynamic-Island-Medium/: iPhone Dynamic Island (Medium display), 1206 x 2622.
iPhone-Duo/: iPhone Duo, 1398 x 2034 (outer display).
Header-Asset/: Choose one PNG in App Store Connect's Header Asset slot.
  header-16x9.png: 5244 x 2950. header-21x9.png: 3840 x 1646.

Keep the five screenshots in numeric order within each set. Do not mix display
classes in one upload slot. The existing 1320 x 2868 iPhone set belongs in the
Dynamic Island (Large display) slot; iPad and Android sets remain separate.
'''


def make_zip(path, entries, include_instructions=False):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for source, name in entries:
            bundle.write(source, name)
        if include_instructions:
            bundle.writestr('UPLOAD.txt', instructions)
    with zipfile.ZipFile(path) as bundle:
        assert bundle.testzip() is None
        for source, name in entries:
            assert bundle.read(name) == source.read_bytes(), name
    print(f'Verified {path.name}: {len(entries) + int(include_instructions)} files')


entries = []
for folder in ['fastlane/metadata', 'fastlane/screenshots', 'store-assets']:
    entries.extend((path, path.relative_to(APP).as_posix()) for path in sorted((APP / folder).rglob('*')) if path.is_file() and not any(part.startswith('.') for part in path.relative_to(APP / folder).parts))
for relative in ['listing-review.html', 'apple-assets-review.html', '.listing-kit/listing.json', '.listing-kit/asset-plan.json']:
    entries.append((APP / relative, relative))
make_zip(OUT / 'Shellbell-store-listings-en-US.zip', entries)
additions = []
for target, files in apple_groups:
    folder = {'iphone-medium': 'Dynamic-Island-Medium', 'iphone-duo': 'iPhone-Duo'}.get(target['family'])
    if folder:
        additions.extend((path, f'{folder}/{path.name}') for path in files)
additions.extend((path, f'Header-Asset/{path.name}') for _, path in headers)
make_zip(OUT / 'Shellbell-Apple-additions-en-US.zip', additions, include_instructions=True)
for target, files in apple_groups:
    if target['family'] == 'iphone-duo':
        make_zip(OUT / 'Shellbell-iPhone-Duo-en-US.zip', [(path, path.name) for path in files])
print('Validated every planned screenshot and header size; wrote apple-assets-review.html.')
