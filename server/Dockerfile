FROM node:20-alpine
WORKDIR /app

# Native modules (bcrypt, shamirs-secret-sharing) compile from source on
# Alpine/musl, which needs a toolchain. Also include wget for the healthcheck.
RUN apk add --no-cache python3 make g++ wget

COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]