FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache postgresql-client docker-cli docker-cli-compose
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 3200
CMD ["npm", "start"]
