#!/bin/bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo 'Node.js is required: https://nodejs.org/'; exit 1; }
npm install
npm start
