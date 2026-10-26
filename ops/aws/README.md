# ReleaseDeck production CI/CD infrastructure

The GitHub workflow uses the existing account OIDC provider. It deliberately does
not modify that provider because it is shared with other applications.

- `production-frontend` can assume only `ReleaseDeckGitHubFrontendProduction`.
  The role can upload dashboard assets, `index.html`, and `release.json` to the
  production bucket and invalidate the one production distribution.
- `production-backend` can assume only `ReleaseDeckGitHubBackendProduction`.
  The role can invoke `ReleaseDeck-DeployApiProduction` on the one approved EC2
  instance and read that command's result.
- Each role uses the matching policy as both its inline permission policy and
  its permissions boundary.
- Both trust policies require the immutable GitHub owner/repository IDs, main
  ref, exact environment, exact workflow name, and the AWS STS audience.

The SSM document accepts only a full commit SHA. It hardcodes the repository,
service, release paths, build commands, verification endpoints, and instance
ports. Repository build steps run as the non-login `releasedeck-build` user.
Promotion is an atomic symlink replacement followed by a restart of only
`releasedeck-api.service`.

Before promotion, the document proves that the current release is healthy,
authenticated, loopback-bound, and therefore eligible as the sole rollback
target. A failed candidate is restored only to that release. If it cannot be
restored and re-proven, the API is stopped rather than exposing an unverified
historical release. The worker must be disabled and inactive before, during,
and after deployment.
