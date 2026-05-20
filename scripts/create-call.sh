#!/bin/bash

curl -sS http://127.0.0.1:3000/calls \
  -H 'content-type: application/json' \
  -d '{"contextPrompt":"Test interview call for Deepgram transcription.","conferenceName":"interview-test"}'