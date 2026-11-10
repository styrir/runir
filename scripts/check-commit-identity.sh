#!/usr/bin/env bash
# Fails if any commit selected by the given `git rev-list` arguments would put an
# identity on this public repo that must not be there:
#   - a Co-authored-by trailer (GitHub lists every co-author as a contributor)
#   - an author or committer email outside COMMIT_IDENTITY_ALLOWED_EMAILS
#   - a term from the untracked local list <git-common-dir>/info/private-terms
#     (one term per line, # comments), checked in messages and added lines.
# Used by .githooks/pre-push and CI.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <rev-list args, e.g. HEAD or old..new>" >&2
  exit 2
fi

allowed=" ${COMMIT_IDENTITY_ALLOWED_EMAILS:-styrir@users.noreply.github.com noreply@github.com} "
terms_file="$(git rev-parse --git-common-dir)/info/private-terms"
terms=""
if [ -f "$terms_file" ]; then
  terms="$(grep -v '^[[:space:]]*#' "$terms_file" | sed '/^[[:space:]]*$/d' || true)"
fi

fail=0
while read -r commit; do
  short="$(git rev-parse --short "$commit")"
  message="$(git log -1 --format=%B "$commit")"
  if printf '%s\n' "$message" | grep -qi '^[[:space:]]*co-authored-by:'; then
    echo "$short: has a Co-authored-by trailer" >&2
    fail=1
  fi
  for email in $(git log -1 --format='%ae %ce' "$commit"); do
    case "$allowed" in
      *" $email "*) ;;
      *) echo "$short: author/committer email $email is not allowed" >&2; fail=1 ;;
    esac
  done
  if [ -n "$terms" ]; then
    if { printf '%s\n' "$message"; git show --format= --no-color -U0 "$commit" | grep '^+' || true; } \
      | grep -qiF -- "$terms"; then
      echo "$short: contains a term from $terms_file" >&2
      fail=1
    fi
  fi
done < <(git rev-list "$@")

if [ "$fail" -ne 0 ]; then
  echo "Commit identity check failed. Commit as styrir <styrir@users.noreply.github.com> with no co-author trailers." >&2
fi
exit "$fail"
