# Changelog

This integration follows [Semantic Versioning](https://semver.org).

## 0.1.1

- Every Cloudinary call identifies the integration with the User-Agent
  `CloudinaryEtchv/<version> (Node.js <version>)`.

## 0.1.0

- Watermark public image uploads from Cloudinary's upload notifications and
  store the watermarked copy as `<public_id>_etchv`.
