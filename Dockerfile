FROM node:24.11.1-slim

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

# Start the app
ENV NODE_ENV=production
ENTRYPOINT [ "node", "dist/index.js" ]
