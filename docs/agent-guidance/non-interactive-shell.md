# Non-interactive shell operations

Load this document before running shell commands that can prompt, overwrite,
delete, copy, move, install, or connect to another machine.

Always use non-interactive flags with file operations. Commands such as `cp`,
`mv`, and `rm` may be aliased to include interactive confirmation, which can
leave an unattended agent waiting indefinitely.

Use:

```bash
# Force overwrite without prompting
cp -f source dest
mv -f source dest
rm -f file

# Recursive operations
rm -rf directory
cp -rf source dest
```

Other commands that may prompt:

- `scp`: use `-o BatchMode=yes`;
- `ssh`: use `-o BatchMode=yes`;
- `apt-get`: use `-y`;
- `brew`: set `HOMEBREW_NO_AUTO_UPDATE=1`.

Before a destructive operation, resolve the exact target with a read-only
check. Do not use a home directory, repository root, workspace root, unresolved
environment variable, broad glob, or filesystem root as a recursive target.

Prefer recoverable operations when practical, and report what was removed.
