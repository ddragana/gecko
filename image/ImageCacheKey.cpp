/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ImageCacheKey.h"

#include "mozilla/HashFunctions.h"
#include "mozilla/Move.h"
#include "nsContentUtils.h"
#include "nsLayoutUtils.h"
#include "nsString.h"
#include "mozilla/dom/BlobURLProtocolHandler.h"
#include "mozilla/dom/File.h"
#include "mozilla/dom/ServiceWorkerManager.h"
#include "nsIDocument.h"
#include "nsPrintfCString.h"

namespace mozilla {

using namespace dom;

namespace image {

static Maybe<uint64_t>
BlobSerial(nsIURI* aURI)
{
  nsAutoCString spec;
  aURI->GetSpec(spec);

  RefPtr<BlobImpl> blob;
  if (NS_SUCCEEDED(NS_GetBlobForBlobURISpec(spec, getter_AddRefs(blob))) &&
      blob) {
    return Some(blob->GetSerialNumber());
  }

  return Nothing();
}

ImageCacheKey::ImageCacheKey(nsIURI* aURI,
                             const OriginAttributes& aAttrs,
                             nsIDocument* aDocument,
                             nsresult& aRv)
  : mURI(aURI)
  , mOriginAttributes(aAttrs)
  , mControlledDocument(GetSpecialCaseDocumentToken(aDocument, aURI))
  , mHash(0)
  , mIsChrome(false)
{
  if (SchemeIs("blob")) {
    mBlobSerial = BlobSerial(mURI);
  } else if (SchemeIs("chrome")) {
    mIsChrome = true;
  }

  // Since we frequently call Hash() several times in a row on the same
  // ImageCacheKey, as an optimization we compute our hash once and store it.

  nsPrintfCString ptr("%p", mControlledDocument);
  nsAutoCString suffix;
  mOriginAttributes.CreateSuffix(suffix);

  if (mBlobSerial) {
    aRv = mURI->GetRef(mBlobRef);
    NS_ENSURE_SUCCESS_VOID(aRv);
    mHash = HashGeneric(*mBlobSerial, HashString(mBlobRef));
  } else {
    nsAutoCString spec;
    aRv = mURI->GetSpec(spec);
    NS_ENSURE_SUCCESS_VOID(aRv);
    mHash = HashString(spec);
  }

  mHash = AddToHash(mHash, HashString(suffix), HashString(ptr));
}

ImageCacheKey::ImageCacheKey(const ImageCacheKey& aOther)
  : mURI(aOther.mURI)
  , mBlobSerial(aOther.mBlobSerial)
  , mBlobRef(aOther.mBlobRef)
  , mOriginAttributes(aOther.mOriginAttributes)
  , mControlledDocument(aOther.mControlledDocument)
  , mHash(aOther.mHash)
  , mIsChrome(aOther.mIsChrome)
{ }

ImageCacheKey::ImageCacheKey(ImageCacheKey&& aOther)
  : mURI(std::move(aOther.mURI))
  , mBlobSerial(std::move(aOther.mBlobSerial))
  , mBlobRef(std::move(aOther.mBlobRef))
  , mOriginAttributes(aOther.mOriginAttributes)
  , mControlledDocument(aOther.mControlledDocument)
  , mHash(aOther.mHash)
  , mIsChrome(aOther.mIsChrome)
{ }

bool
ImageCacheKey::operator==(const ImageCacheKey& aOther) const
{
  // Don't share the image cache between a controlled document and anything else.
  if (mControlledDocument != aOther.mControlledDocument) {
    return false;
  }
  // The origin attributes always have to match.
  if (mOriginAttributes != aOther.mOriginAttributes) {
    return false;
  }
  if (mBlobSerial || aOther.mBlobSerial) {
    // If at least one of us has a blob serial, just compare the blob serial and
    // the ref portion of the URIs.
    return mBlobSerial == aOther.mBlobSerial &&
           mBlobRef == aOther.mBlobRef;
  }

  // For non-blob URIs, compare the URIs.
  bool equals = false;
  nsresult rv = mURI->Equals(aOther.mURI, &equals);
  return NS_SUCCEEDED(rv) && equals;
}

bool
ImageCacheKey::SchemeIs(const char* aScheme)
{
  bool matches = false;
  return NS_SUCCEEDED(mURI->SchemeIs(aScheme, &matches)) && matches;
}

/* static */ void*
ImageCacheKey::GetSpecialCaseDocumentToken(nsIDocument* aDocument, nsIURI* aURI)
{
  // For controlled documents, we cast the pointer into a void* to avoid
  // dereferencing it (since we only use it for comparisons).
  void* pointer = nullptr;
  RefPtr<ServiceWorkerManager> swm = ServiceWorkerManager::GetInstance();
  if (aDocument && swm) {
    ErrorResult rv;
    if (aDocument->GetController().isSome()) {
      pointer = aDocument;
    }
  }

  // If this document has been marked as tracker, let's use its address to make
  // a unique cache key.
  if (!pointer && aDocument &&
      nsContentUtils::StorageDisabledByAntiTracking(nullptr,
                                                    aDocument->GetChannel(),
                                                    aURI)) {
    pointer = aDocument;
  }

  return pointer;
}

} // namespace image
} // namespace mozilla
