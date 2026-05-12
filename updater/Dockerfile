FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git docker-cli docker-cli-compose
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 3100
CMD ["npm", "start"]
