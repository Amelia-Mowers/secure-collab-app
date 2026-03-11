# Contributing to Secure Collaborative Workspace

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/secure-collab-app.git
   cd secure-collab-app
   ```
3. **Set up the development environment**:
   ```bash
   # Using Nix (recommended)
   nix develop

   # Or install dependencies manually (see README.md)
   ```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Your Changes

Follow the coding standards described below.

### 3. Test Your Changes

```bash
# Run all tests
make test

# Quick checks (format, lint, unit tests)
make quick

# Specific test suites
cargo test -p tables-over-matrix
cargo test -p app-core
```

### 4. Commit Your Changes

Write clear, descriptive commit messages:

```bash
git commit -m "Add feature: description of what you added"
# or
git commit -m "Fix: description of what you fixed"
```

### 5. Push and Create a Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub.

## Coding Standards

### Rust Code

1. **Format your code**:
   ```bash
   cargo fmt
   ```

2. **Run Clippy** and fix warnings:
   ```bash
   cargo clippy --all-targets --all-features -- -D warnings
   ```

3. **No panics in library code**: Use `Result<T, E>` for error handling
   ```rust
   // ✓ Good
   pub fn do_something() -> Result<Value, Error> {
       // ...
   }

   // ✗ Bad
   pub fn do_something() -> Value {
       // ... panic!("oops")
   }
   ```

4. **Document public APIs**:
   ```rust
   /// Creates a new cell with the given parameters.
   ///
   /// # Arguments
   ///
   /// * `id` - The cell identifier
   /// * `value` - The cell value
   ///
   /// # Returns
   ///
   /// A new `Cell` instance
   pub fn new(id: CellId, value: serde_json::Value) -> Self {
       // ...
   }
   ```

5. **Write tests**:
   ```rust
   #[cfg(test)]
   mod tests {
       use super::*;

       #[test]
       fn test_cell_creation() {
           // ...
       }
   }
   ```

### TypeScript/React Code

1. **Use TypeScript** for type safety

2. **Follow the ESLint rules**:
   ```bash
   cd ui
   npm run lint
   ```

3. **Write tests** for components and hooks

4. **Use functional components** and hooks

### Git Commit Messages

Follow conventional commits format:

- `feat: add new feature`
- `fix: fix bug in X`
- `docs: update documentation`
- `test: add tests for X`
- `refactor: refactor X`
- `chore: update dependencies`

## Testing Guidelines

### Test-Driven Development

We encourage TDD:

1. Write a failing test
2. Implement the feature
3. Make the test pass
4. Refactor

### Types of Tests

1. **Unit Tests**: Test individual functions/components
   ```rust
   #[test]
   fn test_lww_resolution() {
       // Test LWW logic
   }
   ```

2. **Property-Based Tests**: Test properties that should hold for any input
   ```rust
   proptest! {
       #[test]
       fn test_convergence(updates in vec(arb_cell_update(), 1..20)) {
           // Test convergence property
       }
   }
   ```

3. **Integration Tests**: Test interactions between components
   ```rust
   #[tokio::test]
   #[ignore] // Requires homeserver
   async fn test_two_client_sync() {
       // Test actual Matrix sync
   }
   ```

### Running Tests

```bash
# All tests
cargo test

# Specific crate
cargo test -p tables-over-matrix

# Specific test
cargo test test_lww_resolution

# With output
cargo test -- --nocapture

# Integration tests (requires setup)
cargo test --ignored
```

## Pull Request Process

1. **Update documentation** if you changed APIs
2. **Add tests** for new functionality
3. **Ensure all tests pass**:
   ```bash
   make test
   ```
4. **Update the README** if needed
5. **Describe your changes** clearly in the PR description

### PR Checklist

- [ ] Code follows the project's coding standards
- [ ] All tests pass
- [ ] New tests added for new functionality
- [ ] Documentation updated
- [ ] Commit messages are clear and follow conventions
- [ ] No unnecessary dependencies added

## Code Review

All submissions require review. We aim to:

- Review PRs within 48 hours
- Provide constructive feedback
- Maintain a welcoming environment

## Architecture Decisions

For significant changes:

1. **Open an issue** to discuss the design first
2. **Reference the architecture document** (architecture.md)
3. **Consider creating an ADR** (Architecture Decision Record) for major decisions

## Questions?

- Open an issue for questions about contributing
- Check existing issues and pull requests
- Read the architecture document for design context

## Code of Conduct

Be respectful and professional. We're all here to build something great together.

## License

By contributing, you agree that your contributions will be licensed under the project's MIT OR Apache-2.0 license.
