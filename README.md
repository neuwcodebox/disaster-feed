# 🚀 Hono Boilerplate

A simple Hono boilerplate for building RESTful APIs.

## 🛠️ Tech Stack

- **Runtime/Language**: Node.js, TypeScript
- **Web Framework**: Hono
- **ORM/Database**: Kysely, better-sqlite3, SQLite
- **DI/Architecture**: Inversify
- **Environment Variables**: dotenv
- **API Documentation**: Swagger UI, zod-openapi
- **Logging**: pino
- **Testing**: Vitest
- **Build/Dev Tools**: tsup, tsx, Vite
- **Code Quality/Formatter**: Biome, lint-staged, Husky

## 🏗️ Architecture

This project follows a layered architecture at both the top-level and within each module:

- **Top-level layers:**
  - `core`: Core logic and shared dependencies
  - `infra`: External infrastructure (e.g., database)
  - `view`: HTTP API routes and middleware
  - `modules`: Feature modules, each with its own layers

- **Module structure:**
  - `app`: Business logic such as services
  - `infra`: External infrastructure (e.g., DB repositories)
  - `view`: HTTP API route definitions
  - `domain`: Shared dependencies, DTOs, entities, interfaces, etc. (referenced by other modules)
