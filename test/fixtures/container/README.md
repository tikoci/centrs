# Container image fixture

`scratch-hello.tar` is a synthetic image for `transfer` tests that need a
RouterOS container root (#636). It holds one file, `/hello.txt`, and no binary,
so the container never runs. Importing it (`/container/add file=…`) is enough
for RouterOS to create a root directory whose children `/file print` does not
list.

It is a classic `docker save` archive (`manifest.json`, a config, one layer),
written by hand: RouterOS 7.25.1 rejects the OCI-layout tar a current
`docker save` produces ("no config found in manifest"). Provenance: generated
2026-11-11 with this Python (standard library only), and byte-reproducible
(sha256 `a0f8f5b0328ff5ce2afb2d7f3766f4564c691328bfb287613ca1c33878695f3e`):

```python
import hashlib, io, json, sys, tarfile

def add(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), 0, 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    tar.addfile(info, io.BytesIO(data))

layer_buf = io.BytesIO()
with tarfile.open(fileobj=layer_buf, mode="w", format=tarfile.USTAR_FORMAT) as layer:
    add(layer, "hello.txt", b"centrs #636 fixture\n")
layer_bytes = layer_buf.getvalue()
diff_id = "sha256:" + hashlib.sha256(layer_bytes).hexdigest()
config = json.dumps(
    {
        "architecture": "amd64",
        "os": "linux",
        "config": {},
        "rootfs": {"type": "layers", "diff_ids": [diff_id]},
        "history": [{"created_by": "COPY hello.txt /hello.txt"}],
    },
    separators=(",", ":"),
    sort_keys=True,
).encode()
config_name = hashlib.sha256(config).hexdigest() + ".json"
manifest = json.dumps(
    [{"Config": config_name, "RepoTags": ["centrs-636-fixture:1"], "Layers": ["layer/layer.tar"]}],
    separators=(",", ":"),
).encode()
with tarfile.open(sys.argv[1], mode="w", format=tarfile.USTAR_FORMAT) as out:
    add(out, "manifest.json", manifest)
    add(out, config_name, config)
    add(out, "layer/layer.tar", layer_bytes)
```

No secrets and no third-party content.
