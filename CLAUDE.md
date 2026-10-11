# Keys99 Admin — working rules

- **Every image upload must be compressed before it is uploaded: WebP, as small as it can be
  without visible loss (fixed quality ~75%, max 1920px), and never over 100 KB.**
  Route all image uploads (project media, floor plans, documents/litigation images,
  construction updates, blog covers, and any new upload added later) through
  `prepareImageForUpload()` in `js/image-compress.js`. Never upload an image as the
  original file; if compression fails, refuse the upload with a message. PDFs and other
  non-image files are uploaded unchanged.
- Run `scripts/stamp-build.sh` before committing any change that should go live, so
  browsers load the new JS/CSS instead of cached copies.
