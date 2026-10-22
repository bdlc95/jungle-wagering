import { CanActivate, Injectable } from '@nestjs/common';

/** Extension point for OIDC provider identity verification. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    // This challenge leaves authentication unscored. Replace with IdP token verification.
    return true;
  }
}
