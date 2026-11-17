"""Crop, trim and compose raw screenshots into docs/images. Usage: postprocess.py <rawDir> <outDir>"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw

PHONE_SOURCE = (1170, 2532)  # 390 x 844 CSS px at 3x
PHONE_OUT = (780, 1688)      # stored at 2x
PHONE_RADIUS = 56


def rounded(image, radius):
    mask = Image.new('L', image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    out = image.convert('RGBA')
    out.putalpha(mask)
    return out


def content_box(image):
    background = Image.new('RGB', image.size, image.getpixel((image.width - 2, image.height - 2)))
    return ImageChops.difference(image, background).getbbox()


def save(image, out_dir, name):
    path = os.path.join(out_dir, name)
    image.save(path, optimize=True)
    print(f'{name}: {image.width}x{image.height}, {os.path.getsize(path) // 1024} KB')


def main(raw_dir, out_dir):
    open_raw = lambda name: Image.open(os.path.join(raw_dir, f'{name}.png')).convert('RGB')

    phones = {}
    for state in ('approval', 'question', 'enroll'):
        image = open_raw(f'phone-{state}').crop((0, 0, *PHONE_SOURCE)).resize(PHONE_OUT, Image.LANCZOS)
        phones[state] = rounded(image, PHONE_RADIUS)
        save(phones[state], out_dir, f'phone-{state}.png')

    gap = 80
    hero = Image.new('RGBA', (PHONE_OUT[0] * 2 + gap, PHONE_OUT[1]), (0, 0, 0, 0))
    hero.alpha_composite(phones['approval'], (0, 0))
    hero.alpha_composite(phones['question'], (PHONE_OUT[0] + gap, 0))
    save(hero.resize((hero.width // 2, hero.height // 2), Image.LANCZOS), out_dir, 'hero.png')

    for name in ('settings-light', 'settings-dark'):
        image = open_raw(name)
        image = image.crop((0, 0, image.width, min(image.height, content_box(image)[3] + 64)))
        save(image.resize((image.width * 3 // 4, image.height * 3 // 4), Image.LANCZOS), out_dir, f'{name}.png')

    for name in ('card-encryption', 'card-messages', 'card-phone'):
        image = open_raw(name)
        left, top, right, bottom = content_box(image)
        margin = 24
        save(image.crop((max(0, left - margin), max(0, top - margin),
                         min(image.width, right + margin), min(image.height, bottom + margin))), out_dir, f'{name}.png')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
