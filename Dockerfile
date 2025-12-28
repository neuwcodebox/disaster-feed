FROM node:24.11.1-slim AS builder

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm ci

# Bundle app source
COPY . .

# Build the TypeScript files
RUN npm run build

FROM node:24.11.1-slim AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV HUSKY=0

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/scripts ./scripts

# Start the app
ENTRYPOINT [ "node", "dist/index.js" ]
