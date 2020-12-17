FROM node:14-buster-slim

ENV NODE_ENV=production
ENV NODE_APP_INSTANCE=docker

RUN apt-get update \
	&& apt-get --assume-yes dist-upgrade \
	&& apt-get --assume-yes --no-install-recommends install python build-essential \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app
WORKDIR /app
COPY package.json .
COPY package-lock.json .
RUN npm install --production
RUN npm install sqlite3
RUN apt-get remove --assume-yes --purge python build-essential \
    && apt-get autoremove --assume-yes --purge \
    && apt-get clean
COPY swagger swagger/
COPY migrations migrations/
COPY src src/
COPY config/default.yaml config/default-docker.yaml config/custom-environment-variables.yaml config/

EXPOSE 10010 10011

CMD [ "npm", "start" ]
