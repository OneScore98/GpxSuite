#!/bin/bash
# commit-and-push.command — commit di tutte le modifiche correnti e push su origin/main
# Doppio click su macOS per eseguire (oppure: bash commit-and-push.command).

set -euo pipefail

# Vai nella cartella dello script (così funziona anche col doppio click).
cd "$(dirname "$0")"

BRANCH="main"

echo "==> Cartella: $(pwd)"
echo "==> Branch corrente: $(git rev-parse --abbrev-ref HEAD)"

# Controllo branch
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  echo "!! Non sei su '$BRANCH' (sei su '$CURRENT_BRANCH')."
  read -r -p "   Vuoi passare a '$BRANCH'? [s/N] " ans
  case "$ans" in
    s|S|si|SI|y|Y|yes) git checkout "$BRANCH" ;;
    *) echo "   Annullato."; exit 1 ;;
  esac
fi

# Verifica che ci sia qualcosa da committare
if git diff --quiet && git diff --cached --quiet; then
  echo "==> Nessuna modifica da committare. Faccio solo push."
else
  echo "==> Modifiche rilevate:"
  git status --short
  echo

  # Messaggio commit: usa $1 se passato, altrimenti chiedilo, altrimenti default.
  if [ "${1-}" != "" ]; then
    MSG="$1"
  else
    DEFAULT_MSG="Aggiornamenti GpxSuite ($(date +%Y-%m-%d_%H:%M))"
    read -r -p "Messaggio commit [$DEFAULT_MSG]: " MSG
    MSG="${MSG:-$DEFAULT_MSG}"
  fi

  echo "==> git add -A"
  git add -A

  echo "==> git commit -m \"$MSG\""
  git commit -m "$MSG"
fi

echo "==> Aggiorno remoto: git fetch origin"
git fetch origin

# Pull rebase per evitare merge spuri se ci sono commit nuovi su remote.
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  AHEAD=$(git rev-list --count "origin/$BRANCH..$BRANCH" || echo 0)
  BEHIND=$(git rev-list --count "$BRANCH..origin/$BRANCH" || echo 0)
  echo "==> Confronto con origin/$BRANCH: ahead=$AHEAD, behind=$BEHIND"
  if [ "$BEHIND" -gt 0 ]; then
    echo "==> git pull --rebase origin $BRANCH"
    git pull --rebase origin "$BRANCH"
  fi
fi

echo "==> git push origin $BRANCH"
git push origin "$BRANCH"

echo
echo "Fatto. Ultimo commit:"
git --no-pager log -1 --oneline
