---
title: Agent Monitors
description: Durable observation and inbox delivery for AI agents
---

# Agent Monitors

Durable observation and inbox delivery for AI agents.

## What is Agent Monitors?

Agent Monitors is a system that lets AI agents subscribe to external changes — file modifications, API responses, scheduled events — and receive durable inbox items they can recover after restart.

## Key Features

- **Declarative monitors** — Define monitors as markdown files with YAML frontmatter
- **Durable inbox** — SQLite-backed inbox with full lifecycle management
- **Plugin architecture** — Observation sources are npm packages following a simple interface
- **Hook bridge** — Integrates with AI coding tool hooks for real-time notification
- **Notification strategies** — Debounce and throttle to control signal frequency

## Get Started

Read the [Getting Started guide](/docs/getting-started) to set up your first monitor.
