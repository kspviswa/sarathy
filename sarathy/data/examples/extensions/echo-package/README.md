# Example Extension (package form)

This directory demonstrates the package-style extension layout: a directory
with `pyproject.toml` declaring `[tool.tau] extensions = [...]` (a list of
entry files), whose entry module is discovered from the manifest.

```
echo-package/
├── pyproject.toml      # [tool.tau] extensions = ["extension.py"]
├── extension.py        # setup(sarathy) entry point
└── helper.py           # sibling module, reached via `from . import helper`
```

Copy this whole directory to `~/.sarathy/extensions/` to install it. The
extension registers a `hello` tool and a `/hello` command.

## pyproject.toml

```toml
[tool.tau]
extensions = ["extension.py"]
```

The manifest takes precedence over an `extension.py` in the same directory;
each declared file loads as a package rooted at its parent directory, so
sibling modules stay importable with relative imports.

## extension.py

```python
def setup(sarathy):
    sarathy.register_command(
        "hello",
        lambda args, ctx: f"Hello from package extension. Args: {args}",
        description="Say hello.",
    )
```

See `sarathy/data/docs/EXTENSIONS.md` for the full extension reference.