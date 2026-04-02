# Contributing to CRISP

Thank you for your interest in improving crisis response technology. CRISP is built to save lives, and every contribution matters.

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](../../issues) to report bugs or request features
- Include steps to reproduce, expected behavior, and screenshots if applicable
- Tag issues with `bug`, `enhancement`, `accessibility`, or `security`

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Test locally: `bash start.sh` and verify both mobile app and dashboard
5. Submit a PR with a clear description of what changed and why

### Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/crisp-platform.git
cd crisp-platform

# Copy environment template
cp .env.example .env
# Add your API keys to .env

# Start development servers
bash start.sh
```

### Code Style

- **Python (backend)**: Follow PEP 8, use type hints
- **JavaScript (frontend)**: Vanilla JS, no build step required
- **CSS**: Use existing CSS custom properties (`var(--accent)`, `var(--text)`, etc.)
- **Commits**: Concise messages describing the "why", not the "what"

### Areas Where Help Is Needed

- **Accessibility**: WCAG 2.1 AA compliance, ARIA labels, screen reader testing
- **Localization**: Adding new languages to the i18n dictionary
- **Security**: Encryption at rest, TLS configuration guides
- **Testing**: Unit tests for backend API, integration tests for sync flow
- **Documentation**: Deployment guides for AWS, Azure, GCP
- **Mobile**: Native wrapper (Capacitor/Cordova) for app store distribution

## Code of Conduct

- Be respectful and constructive
- Focus on the mission: helping communities in crisis
- Prioritize accessibility and inclusion in all design decisions

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
