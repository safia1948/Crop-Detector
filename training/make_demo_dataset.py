#!/usr/bin/env python3
"""
Make a SYNTHETIC leaf dataset with known lesion area, to check the whole pipeline
(train.py -> model -> eval_severity.py) before you have real photos.

    python training/make_demo_dataset.py --out demo --per-class 60

Creates demo/dataset/<class>/*.jpg, demo/class_map.json and demo/truth.json
({"wheat_leaf_rust/rust_007.jpg": 23.4, ...} = real affected % of the leaf).

These are drawings, not real leaves: use them only to see that training, export and the
severity numbers work end to end. Never quote the accuracy you get on them.
"""
import argparse, json, os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

CLASSES = {  # folder -> (disease index in diseases.json for wheat, lesion colour)
    "wheat_healthy": (-1, None),
    "wheat_leaf_rust": (0, (214, 120, 30)),     # orange pustules
    "wheat_stem_rust": (1, (120, 60, 30)),      # dark brown streaks
}


def leaf_image(rng, size=448):
    bg = tuple(rng.randint(150, 200) for _ in range(3))
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    g = (rng.randint(50, 90), rng.randint(130, 170), rng.randint(40, 80))
    d.ellipse([size * .05, size * .22, size * .95, size * .78], fill=g)       # leaf blade
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([size * .05, size * .22, size * .95, size * .78], fill=255)
    return im, mask


def add_lesions(rng, im, mask, colour, streaks):
    size = im.size[0]
    les = Image.new("L", (size, size), 0)
    ld = ImageDraw.Draw(les)
    for _ in range(rng.randint(2, 14)):
        cx, cy = rng.randint(int(size * .12), int(size * .88)), rng.randint(int(size * .3), int(size * .7))
        if streaks:
            ld.line([cx, cy, cx + rng.randint(-60, 60), cy + rng.randint(-25, 25)], fill=255, width=rng.randint(5, 14))
        else:
            r = rng.randint(8, 34)
            ld.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    les = Image.fromarray(np.minimum(np.array(les), np.array(mask)))            # lesions only on the leaf
    im.paste(Image.new("RGB", im.size, colour), mask=les)
    return im, les


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="demo")
    ap.add_argument("--per-class", type=int, default=60)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    truth, cmap = {}, {}
    for name, (dis, col) in CLASSES.items():
        os.makedirs(os.path.join(a.out, "dataset", name), exist_ok=True)
        cmap[name] = {"crop": "wheat", "disease": dis}
        for i in range(a.per_class):
            im, mask = leaf_image(rng)
            pct = 0.0
            if col:
                im, les = add_lesions(rng, im, mask, col, streaks=(dis == 1))
                leaf_px = max(1, int((np.array(mask) > 0).sum()))
                pct = round(100.0 * (np.array(les) > 0).sum() / leaf_px, 1)
            im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0, 1.2)))
            f = f"{name.split('_', 1)[1]}_{i:03d}.jpg"
            im.save(os.path.join(a.out, "dataset", name, f), quality=88)
            truth[f"{name}/{f}"] = pct
    json.dump(cmap, open(os.path.join(a.out, "class_map.json"), "w"), indent=1)
    json.dump(truth, open(os.path.join(a.out, "truth.json"), "w"), indent=1)
    print(f"Wrote {len(truth)} images to {a.out}/dataset")


if __name__ == "__main__":
    main()
