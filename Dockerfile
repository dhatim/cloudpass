FROM node:12-buster-slim

ENV NODE_ENV=production
ENV NODE_APP_INSTANCE=docker

RUN mkdir -p /app
WORKDIR /app
COPY package.json .
COPY package-lock.json .

RUN apt-get update \
	&& apt-get --assume-yes dist-upgrade \
	&& apt-get --assume-yes --no-install-recommends install python build-essential \
  && npm install --production \
  && npm install sqlite3 \
  && apt-get remove --assume-yes --purge python build-essential \
  && apt-get autoremove --assume-yes --purge \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY swagger swagger/
COPY migrations migrations/
COPY src src/
COPY config/default.yaml config/default-docker.yaml config/custom-environment-variables.yaml config/

EXPOSE 10010 10011

CMD [ "npm", "start" ]
