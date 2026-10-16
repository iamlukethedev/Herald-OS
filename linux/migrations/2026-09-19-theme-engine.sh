#!/usr/bin/env bash
# Migration: machines provisioned before the theme engine need theme.kdl and the default theme applied.
# Runs as: user
set -euo pipefail
command -v herald-os-theme >/dev/null || exit 0
herald-os-theme set "$(herald-os-theme current)"
