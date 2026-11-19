#!/bin/bash
# Generates public/token-voice/*.m4a with macOS `say` (voice Tara, English India).
# Spoken as: "Attention please. Token" + number (e.g. "one" "twenty three") + "your order is ready"
set -e
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/token-voice"
V="Tara (English (India))"
mkdir -p "$OUT"; rm -f "$OUT"/*.m4a
gen() { say -v "$V" -o "$OUT/$1.m4a" --data-format=aac "$2"; }
gen attention "Attention please. Token"
gen ready "Your order is ready."
gen hundred "hundred"
gen oh "oh"
gen 0 "zero"
words=(zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen)
tens=("" "" twenty thirty forty fifty sixty seventy eighty ninety)
for n in $(seq 1 99); do
  if [ $n -lt 20 ]; then w="${words[$n]}"; else w="${tens[$((n/10))]}"; [ $((n%10)) -gt 0 ] && w="$w ${words[$((n%10))]}"; fi
  gen $n "$w"
done

# Full-sentence clip per token (1..500) so there is no gap between words. Pieces above are the fallback for bigger numbers.
mkdir -p "$OUT/full"
spell() { local n=$1 h r; if [ $n -lt 100 ]; then s2 $n; return; fi; h=$((n/100)); r=$((n%100))
  if [ $r -eq 0 ]; then echo "${words[$h]} hundred"; elif [ $r -lt 10 ]; then echo "${words[$h]} oh ${words[$r]}"; else echo "${words[$h]} $(s2 $r)"; fi; }
s2() { local n=$1; if [ $n -lt 20 ]; then echo "${words[$n]}"; else local w="${tens[$((n/10))]}"; [ $((n%10)) -gt 0 ] && w="$w ${words[$((n%10))]}"; echo "$w"; fi; }
for n in $(seq 1 500); do
  say -v "$V" -o "$OUT/full/$n.m4a" --data-format=aac "Attention please. Token $(spell $n), your order is ready."
done
