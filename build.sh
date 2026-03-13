#!/bin/bash

pnpm install --frozen-lockfile
pnpm run build

rm -rf /app && mkdir /app

cp -R ./.next/standalone/.next /app/
cp -R ./.next/standalone/node_modules /app/
cp -R ./.next/standalone/package.json /app/
cp -R ./.next/standalone/server.js /app/
cp -R ./scripts /app/
cp ./start.js /app/
cp -R ./public /app/
cp -R ./.next/static /app/.next/

