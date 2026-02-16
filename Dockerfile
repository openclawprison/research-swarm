FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY backend/ ./backend/
COPY frontend/ ./frontend/
EXPOSE 3000
CMD ["npm", "start"]
