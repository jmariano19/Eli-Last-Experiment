#!/bin/zsh
cd "/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4" || exit 1

echo "Eli local AI preview"
echo "Paste a NEW OpenAI API key. Input will be hidden."
echo "Do not use any key that was pasted into chat or terminal history."
printf "OPENAI_API_KEY: "
stty -echo
read OPENAI_API_KEY
stty echo
echo

OPENAI_API_KEY="$(printf "%s" "$OPENAI_API_KEY" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
OPENAI_API_KEY="${OPENAI_API_KEY#export OPENAI_API_KEY=}"
OPENAI_API_KEY="${OPENAI_API_KEY#OPENAI_API_KEY=}"
OPENAI_API_KEY="$(printf "%s" "$OPENAI_API_KEY" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
OPENAI_API_KEY="${OPENAI_API_KEY%\"}"
OPENAI_API_KEY="${OPENAI_API_KEY#\"}"
OPENAI_API_KEY="${OPENAI_API_KEY%\'}"
OPENAI_API_KEY="${OPENAI_API_KEY#\'}"

if [[ -z "$OPENAI_API_KEY" ]]; then
  echo "No key entered. Exiting."
  exit 1
fi

if [[ "$OPENAI_API_KEY" != sk-* ]]; then
  echo "That does not look like an OpenAI API key. It should start with sk-."
  exit 1
fi

export OPENAI_API_KEY
export OPENAI_MODEL="${OPENAI_MODEL:-gpt-4.1-mini}"

echo
echo "Starting Eli preview server..."
echo "Key check: starts with ${OPENAI_API_KEY[1,7]}... (${#OPENAI_API_KEY} characters)"
echo "Browser:       http://localhost:4177/test.html?file=first_contact"
echo "Mobile:        http://10.0.0.212:4177/test.html?file=first_contact"
echo

node "/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4/local-server.mjs"
