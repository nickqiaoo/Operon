# Multi-stage build for operon-broker.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /operon-broker .

FROM alpine:3.20
# Copy CA roots from the build image (for outbound TLS, e.g. GitHub OAuth) instead of
# `apk add`, so the final stage needs no network.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /operon-broker /usr/local/bin/operon-broker
EXPOSE 8080
ENTRYPOINT ["operon-broker"]
