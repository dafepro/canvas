# Build the coordination service.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/canvasd ./cmd/canvasd

FROM alpine:3.21
RUN adduser -D -u 10001 canvasd
COPY --from=build /out/canvasd /usr/local/bin/canvasd
COPY server/canvases /etc/canvasd/canvases
USER canvasd
EXPOSE 8080
ENV CANVASD_ADDR=":8080" \
    CANVASD_CANVAS_DIR="/etc/canvasd/canvases" \
    CANVASD_ALLOWED_ORIGINS="*"
ENTRYPOINT ["/usr/local/bin/canvasd"]
