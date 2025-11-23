#!/usr/bin/env zsh
set -euo pipefail

# Small release helper:
# Usage: ./scripts/release.sh <tag> [--notes "release notes"] [--push]
# Example: ./scripts/release.sh v0.3.0-alpha.1 --notes "Alpha release" --push

PROG=${0##*/}
if [[ $# -lt 1 ]]; then
  echo "Usage: $PROG <tag> [--notes \"notes\"] [--push]"
  exit 2
fi

TAG=$1
shift
NOTES="Release $TAG"
DO_PUSH=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes)
      shift
      if [[ $# -eq 0 ]]; then
        echo "--notes requires an argument"
        exit 2
      fi
      NOTES="$1"
      ;;
    --push)
      DO_PUSH=true
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $PROG <tag> [--notes \"notes\"] [--push]"
      exit 2
      ;;
  esac
  shift
done

REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

echo "Preparing release $TAG for repository $REPO_NAME"

# If tag doesn't exist, create an annotated tag from HEAD
if git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists"
else
  git tag -a "$TAG" -m "Release $TAG"
  echo "Created tag $TAG"
  if [[ "$DO_PUSH" == true ]]; then
    git push origin "$TAG"
  fi
fi

ZIP_NAME="${REPO_NAME}-${TAG}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"

echo "Creating zip $ZIP_PATH from tag $TAG"
# Use git archive to ensure only tracked files are included and paths are deterministic
git archive --format=zip --prefix="${REPO_NAME}-${TAG}/" -o "$ZIP_PATH" "$TAG"

echo "Created $ZIP_PATH"

if command -v gh >/dev/null 2>&1; then
  echo "gh CLI found — creating GitHub release"
  # Create a prerelease if it looks like alpha/beta in tag
  PRE_RELEASE_FLAG=""
  if [[ "$TAG" == *alpha* || "$TAG" == *beta* ]]; then
    PRE_RELEASE_FLAG="--prerelease"
  fi
  gh release create "$TAG" "$ZIP_PATH" --title "$TAG" --notes "$NOTES" $PRE_RELEASE_FLAG
  echo "Release $TAG created/updated via gh"
else
  echo "gh CLI not found — release zip created locally: $ZIP_PATH"
  echo "To publish automatically, install GitHub CLI (https://cli.github.com/) and re-run with --push"
  echo "You can also upload $ZIP_PATH manually on the GitHub Releases UI for tag $TAG"
fi

echo "Done"
