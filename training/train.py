#!/usr/bin/env python3
"""
Train the AgriDrone crop-disease classifier and export it for the browser (TensorFlow.js).

    python training/train.py --data dataset --map training/class_map.json --out public/model

dataset/ has ONE FOLDER PER CLASS (any folder names), each full of photos:

    dataset/
      cotton_healthy/ 001.jpg ...
      cotton_leaf_curl/ ...
      wheat_leaf_rust/ ...

class_map.json says what every folder means inside the app (see class_map.example.json):

    { "cotton_healthy":   {"crop": "cotton", "disease": -1},
      "cotton_leaf_curl": {"crop": "cotton", "disease": 0} }

"disease" is the index in the app's list for that crop (see diseases.json), or -1 for healthy.

Output (in --out): model.json + weight shards + labels.json. The server serves them from /model/
and the app starts using deep learning automatically (until then it uses the colour check).

Recommended environment (not tested in the sandbox this was written in):
    pip install "tensorflow==2.15.*" "tensorflowjs==4.17.*"
"""
import argparse
import json
import os
import sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = 224


def make_labels(class_names, class_map, diseases):
    """Pure function (no TensorFlow needed): build labels.json in the SAME order as the model outputs."""
    classes = []
    for name in class_names:
        if name not in class_map:
            raise SystemExit(f"Folder '{name}' is missing from class_map.json")
        m = class_map[name]
        crop, dis = m.get("crop"), m.get("disease")
        if crop not in diseases:
            raise SystemExit(f"'{name}': crop '{crop}' is not one of {sorted(diseases)}")
        if not isinstance(dis, int) or dis < -1 or dis >= len(diseases[crop]):
            raise SystemExit(f"'{name}': disease must be -1 (healthy) or 0..{len(diseases[crop]) - 1} for {crop}")
        classes.append({"label": name, "crop": crop, "disease": dis})
    # Every crop needs a healthy class, otherwise the model can never answer "healthy" for it.
    for crop in {c["crop"] for c in classes}:
        if not any(c["crop"] == crop and c["disease"] == -1 for c in classes):
            print(f"WARNING: crop '{crop}' has no healthy class (disease -1) - it will always report a disease.", file=sys.stderr)
    return {"size": IMG, "norm": "0-1", "classes": classes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--map", default=os.path.join(APP_DIR, "training", "class_map.json"))
    ap.add_argument("--out", default=os.path.join(APP_DIR, "public", "model"))
    ap.add_argument("--epochs", type=int, default=8, help="epochs for the classifier head")
    ap.add_argument("--finetune-epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--keep-keras", default="", help="also save the Keras model here (needed by eval_severity.py)")
    a = ap.parse_args()

    with open(a.map, encoding="utf-8") as f:
        class_map = json.load(f)
    with open(os.path.join(APP_DIR, "diseases.json"), encoding="utf-8") as f:
        diseases = json.load(f)

    import tensorflow as tf
    import tensorflowjs as tfjs

    common = dict(validation_split=0.2, seed=42, image_size=(IMG, IMG), batch_size=a.batch,
                  crop_to_aspect_ratio=True)  # centre-square crop = exactly what the app does at prediction time
    train = tf.keras.utils.image_dataset_from_directory(a.data, subset="training", **common)
    val = tf.keras.utils.image_dataset_from_directory(a.data, subset="validation", **common)
    names = train.class_names                      # alphabetical; model output i == names[i]
    labels = make_labels(names, class_map, diseases)

    scale = lambda x, y: (x / 255.0, y)            # model input is [0,1] (labels.json: norm "0-1")
    train = train.map(scale).shuffle(1000).prefetch(tf.data.AUTOTUNE)
    val = val.map(scale).prefetch(tf.data.AUTOTUNE)

    L = tf.keras.layers
    base = tf.keras.applications.MobileNetV2(input_shape=(IMG, IMG, 3), include_top=False, weights="imagenet")
    base.trainable = False
    inp = tf.keras.Input((IMG, IMG, 3))
    x = L.RandomFlip("horizontal_and_vertical")(inp)           # augmentation: only active while training
    x = L.RandomRotation(0.15)(x)
    x = L.RandomZoom(0.15)(x)
    x = L.RandomContrast(0.2)(x)
    x = L.Rescaling(2.0, offset=-1.0)(x)                        # [0,1] -> [-1,1] as MobileNetV2 expects
    x = base(x, training=False)
    x = L.GlobalAveragePooling2D()(x)
    x = L.Dropout(0.25)(x)
    out = L.Dense(len(names), activation="softmax")(x)
    model = tf.keras.Model(inp, out)

    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    model.fit(train, validation_data=val, epochs=a.epochs)

    base.trainable = True                                       # fine-tune the top of the backbone
    for layer in base.layers[:-30]:
        layer.trainable = False
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-5), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    model.fit(train, validation_data=val, epochs=a.finetune_epochs)

    loss, acc = model.evaluate(val)
    print(f"\nValidation accuracy: {acc:.3f}  (this is on photos from the SAME dataset - test on real field photos before trusting it)")

    if a.keep_keras:
        model.save(a.keep_keras)
    os.makedirs(a.out, exist_ok=True)
    tfjs.converters.save_keras_model(model, a.out)
    with open(os.path.join(a.out, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(labels, f, indent=1)
    print("Saved model + labels.json to", a.out, "- restart not needed, the server reads the files on request.")


if __name__ == "__main__":
    main()
