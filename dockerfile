FROM nginx:latest

# Copy website files
COPY . /usr/share/nginx/html

# Expose web port
EXPOSE 80

