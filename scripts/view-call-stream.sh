#!/bin/bash

CALLID=$1 

curl -N "http://127.0.0.1:3000/calls/$CALLID/stream"
