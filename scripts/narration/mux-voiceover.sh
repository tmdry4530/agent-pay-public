#!/usr/bin/env bash
# Mix per-scene narration clips (S1..S8.mp3) into one audio track and mux it with the
# existing submission video stream (video is copied, not re-encoded).
# Usage: scripts/narration/mux-voiceover.sh <clipDir> [video.webm]
set -euo pipefail
CLIPS=${1:?clip dir}
VIDEO=${2:-docs/demo/agent-pay-submission.webm}
LEAD=0.4                                   # seconds after each scene start
STARTS=(0 20 45 65 90 110 130 150)         # scene starts (s), see docs/submission/video-script.md
TOTAL=170

inputs=(); filters=""; labels=""
for i in "${!STARTS[@]}"; do
  n=$((i + 1))
  inputs+=(-i "$CLIPS/S$n.mp3")
  ms=$(awk -v s="${STARTS[$i]}" -v l="$LEAD" 'BEGIN{printf "%d", (s + l) * 1000}')
  filters+="[$n:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[a$n];"
  labels+="[a$n]"
done
filters+="${labels}amix=inputs=${#STARTS[@]}:normalize=0:dropout_transition=0,"
filters+="loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,"
filters+="apad=whole_dur=${TOTAL},atrim=0:${TOTAL},asetpts=N/SR/TB[aout]"

tmp=$(mktemp --suffix=.webm)
ffmpeg -hide_banner -loglevel error -y -i "$VIDEO" "${inputs[@]}" \
  -filter_complex "$filters" -map 0:v:0 -map "[aout]" \
  -c:v copy -c:a libopus -b:a 96k -ac 1 -t "$TOTAL" "$tmp"
mv "$tmp" "$VIDEO"
ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels,sample_rate \
  -show_entries format=duration,size -of compact "$VIDEO"
