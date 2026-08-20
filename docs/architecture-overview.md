# Architecture Overview

This platform uses a modular monorepo with independent deployable backend services and shared internal packages.

## Services

- gateway: API edge, routing, and request orchestration
- auth-service: Identity and access management
- usage-service: Usage ingestion and normalization
- worker-service: Async jobs and event processing
- billing-service: Metering, rating, and invoice orchestration
- analytics-service: Aggregation and analytical APIs
- web: React dashboard

## Shared Packages

- shared-config
- shared-types
- shared-utils
- shared-validation
- shared-logger
- shared-tracing
