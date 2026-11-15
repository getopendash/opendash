// A SAML identity provider's metadata for tests: a public test certificate (its key exists nowhere) and an SSO
// address. Enough to register a provider and start a sign-in; the full SAML round trip is checked against a local
// Keycloak (`pnpm --filter @opendash/ee keycloak:check`).
/** A public test certificate (no key anywhere): what an identity provider's metadata carries. */
export const STUB_SAML_CERT =
  "MIIDGzCCAgOgAwIBAgIUSerEFctMnkmig6CFkYdN7mEghC4wDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwSc3R1Yi1zYW1sLWlkcC50ZXN0MB4XDTI2MTAyNTE5MTgyNFoXDTM2MTAyMjE5MTgyNFowHTEbMBkGA1UEAwwSc3R1Yi1zYW1sLWlkcC50ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyMjzzTiUk0YSPz5GFjwi+EjWUP4/Vg7grLwKtcQQLls5xrE1njpDhNoSHeVglwbFWNpHfK8xODu1SRNT2ZymH5N5ZkoZcSvyayxdXbGO+sHffBZOWYNOMtijbXkEz/WpzRP3cleN+i6F0J1MDnQxMaaKTY1JO2opvWe92ic4v16nJCjLBcUrZ+DCg7d9QIzKDYKKtk8uULDRmaPO2PiyS/boswNMZ4zIhFhEn76t9kTtH32CFSU+NLFjqjddjaoXBEEy6O7R3ZLXlUzodg5JVEUVH0nrh6df4BFxozZJZq5bU9Foz6aGWfEH2Sum3R8VTrsWWxXCPikNcc1eQvfuPwIDAQABo1MwUTAdBgNVHQ4EFgQUlgtSlZd0mjNGpmtawAmjzkGGRPwwHwYDVR0jBBgwFoAUlgtSlZd0mjNGpmtawAmjzkGGRPwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAalvwdsFMpUCaV9knuynsHgI75kp2AoEWlI3FRLmmPx5gwFqi0kWARStC15AfBmwPMIFmO4cyyk3rQ89BOavcyZUF3QY7OPJjjJlZ3Uk7t3jV2tPphFNnYLpXbkMsDScgXfWpC+5yF4HyxkE/2mhTC2d41P3Va4LEKqodXUppRUKsPT9LMO1Td/7zT4y/Xd1uO2NNQBG69ofxGqwNpCb+nCccooj9jYrrWK7tLMENQUeqFyBK4RZXZUt/giS5/TJ7NXwxXuv2zC2GuZ/E/noXjgQ1Fa/Kjd02qteSFbXXsi1EuVVzbjCWtyKqg6+LRiMuDFjRgDh1KgFnVMGt9efCsg==";

export const samlMetadata = (
  entityId = "https://idp.example.test/saml",
  ssoUrl = "https://idp.example.test/sso",
) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${STUB_SAML_CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
