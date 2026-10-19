#!/usr/bin/env python3
"""
Check how good the app's "affected area" estimate is, using the SAME tiling rules as the app
(public/index.html: dlTiles): ~4x4 grid, leaf-pixel weighting, tile counts as affected when the
model's disease probability >= 0.5, area % = affected leaf area / leaf area.

Needs a Keras model, so train with:  python training/train.py ... --keep-keras model.keras

  A) synthetic demo (pipeline check only):
     python training/eval_severity.py --keras model.keras --labels public/model/labels.json \
            --images demo/dataset --truth demo/truth.json

  B) REAL check against what experts said (use the zip from Owner > Expert feedback > Download dataset):
     python training/eval_severity.py --keras model.keras --labels public/model/labels.json \
            --images expert/dataset --csv expert/expert_labels.csv

Prints mean absolute error (percentage points), correlation, and how often the grade
(Mild <15 / Moderate 15-40 / Severe >40) matches. Diseased photos only.
"""
import argparse, csv, json, os, sys
import numpy as np
from PIL import Image

GRADES = [(15, "Mild"), (40, "Moderate"), (101, "Severe")]
grade = lambda p: next(n for lim, n in GRADES if p < lim)


def leaf_fraction(small, nx, ny):
    """Same colour rules as the app (green / yellow / brown pixels = leaf), per grid cell."""
    a = np.asarray(small.convert("RGB"), dtype=np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    leaf = ((g > r * 1.05) & (g > b * 1.1)) | ((r > 110) & (g > 100) & (b < r * .6) & (abs(r - g) < 70)) | ((r > g) & (g > b) & (r > 60) & (r < 190) & (g < r * .85))
    H, W = leaf.shape
    out = np.zeros((ny, nx))
    for j in range(ny):
        for i in range(nx):
            cell = leaf[j * H // ny:max(j * H // ny + 1, (j + 1) * H // ny), i * W // nx:max(i * W // nx + 1, (i + 1) * W // nx)]
            out[j, i] = cell.mean() if cell.size else 0
    return out.reshape(-1)


def severity(img, predict, classes, crop, size=224):
    """predict(batch float32 [n,size,size,3] in 0..1) -> probabilities [n,K]. Returns (area %, heat list) or None."""
    big = img.copy(); big.thumbnail((448, 448))
    small = img.copy(); small.thumbnail((220, 220))
    W, H = big.size
    t0 = min(W, H) / 4
    nx, ny = max(1, round(W / t0)), max(1, round(H / t0))
    leaf = leaf_fraction(small, nx, ny)
    tiles = [np.asarray(big.crop((round(i * W / nx), round(j * H / ny), round((i + 1) * W / nx), round((j + 1) * H / ny))).resize((size, size), Image.BILINEAR), dtype=np.float32) / 255.0
             for j in range(ny) for i in range(nx)]
    P = np.asarray(predict(np.stack(tiles)))
    idx = [i for i, c in enumerate(classes) if c["crop"] == crop]
    sub = P[:, idx]; sub = sub / np.maximum(sub.sum(1, keepdims=True), 1e-9)
    dis = np.array([classes[i]["disease"] >= 0 for i in idx])
    pd = sub[:, dis].sum(1)
    ok = leaf >= 0.2
    if leaf[ok].sum() <= 0:
        return None
    return round(100 * (leaf[ok] * (pd[ok] >= 0.5)).sum() / leaf[ok].sum()), pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keras", required=True); ap.add_argument("--labels", required=True)
    ap.add_argument("--images", required=True); ap.add_argument("--crop", default="wheat")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--truth"); g.add_argument("--csv")
    a = ap.parse_args()
    import tensorflow as tf
    model = tf.keras.models.load_model(a.keras)
    meta = json.load(open(a.labels, encoding="utf-8")); classes, size = meta["classes"], meta.get("size", 224)
    predict = lambda x: model.predict(x, verbose=0)
    truth = {}
    if a.truth:
        truth = json.load(open(a.truth))
    else:
        for row in csv.DictReader(open(a.csv, encoding="utf-8")):
            if row["expert_crop"] == a.crop and row["expert_affected_pct"] not in ("", "0"):
                truth[f"{row['expert_crop']}_{row['expert_disease'].lower().replace(' ', '_')}/{row['key']}.jpg"] = float(row["expert_affected_pct"])
    rows = []
    for rel, true_pct in truth.items():
        path = os.path.join(a.images, rel)
        if true_pct <= 0 or not os.path.exists(path):
            continue
        res = severity(Image.open(path).convert("RGB"), predict, classes, a.crop, size)
        if res: rows.append((true_pct, res[0]))
    if len(rows) < 5:
        sys.exit(f"Only {len(rows)} usable diseased photos found - need at least ~5 (ideally 30+).")
    t, p = np.array(rows, dtype=float).T
    print(f"photos: {len(rows)}")
    print(f"mean absolute error: {np.abs(t - p).mean():.1f} percentage points")
    print(f"correlation (true vs estimated): {np.corrcoef(t, p)[0, 1]:.2f}")
    print(f"bias (estimated - true): {np.mean(p - t):+.1f} points")
    print(f"grade matches: {np.mean([grade(x) == grade(y) for x, y in zip(t, p)]) * 100:.0f}%")


if __name__ == "__main__":
    main()
