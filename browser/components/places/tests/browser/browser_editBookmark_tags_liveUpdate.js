"use strict";

function checkTagsSelector(aAvailableTags, aCheckedTags) {
  is(PlacesUtils.tagging.allTags.length, aAvailableTags.length,
     "tagging service is in sync.");
  let tagsSelector = document.getElementById("editBMPanel_tagsSelector");
  let children = tagsSelector.childNodes;
  is(children.length, aAvailableTags.length,
      "Found expected number of tags in the tags selector");

  Array.prototype.forEach.call(children, function(aChild) {
    let tag = aChild.getAttribute("label");
    ok(true, "Found tag '" + tag + "' in the selector");
    ok(aAvailableTags.includes(tag), "Found expected tag");
    let checked = aChild.getAttribute("checked") == "true";
    is(checked, aCheckedTags.includes(tag),
       "Tag is correctly marked");
  });
}

add_task(async function() {
  const TEST_URI = Services.io.newURI("http://www.test.me/");
  const TEST_URI2 = Services.io.newURI("http://www.test.again.me/");
  const TEST_TAG = "test-tag";

  ok(gEditItemOverlay, "Sanity check: gEditItemOverlay is in context");

  // Open the tags selector.
  document.getElementById("editBMPanel_tagsSelectorRow").collapsed = false;

  // Add a bookmark.
  let bm = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    index: PlacesUtils.bookmarks.DEFAULT_INDEX,
    type: PlacesUtils.bookmarks.TYPE_BOOKMARK,
    url: TEST_URI.spec,
    title: "test.me"
  });

  // Init panel.
  let node = await PlacesUIUtils.promiseNodeLikeFromFetchInfo(bm);
  gEditItemOverlay.initPanel({ node });

  // Add a tag.
  PlacesUtils.tagging.tagURI(TEST_URI, [TEST_TAG]);

  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], TEST_TAG,
     "Correctly added tag to a single bookmark");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == TEST_TAG,
    "Editing a single bookmark shows the added tag.");
  checkTagsSelector([TEST_TAG], [TEST_TAG]);

  // Remove tag.
  PlacesUtils.tagging.untagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], undefined,
     "The tag has been removed");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing a single bookmark should not show any tag");
  checkTagsSelector([], []);

  // Add a second bookmark.
  let bm2 = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    index: PlacesUtils.bookmarks.DEFAULT_INDEX,
    type: PlacesUtils.bookmarks.TYPE_BOOKMARK,
    title: "test.again.me",
    url: TEST_URI2.spec
  });

  // Init panel with multiple uris.
  gEditItemOverlay.initPanel({ uris: [TEST_URI, TEST_URI2] });

  // Add a tag to the first uri.
  PlacesUtils.tagging.tagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], TEST_TAG,
     "Correctly added a tag to the first bookmark.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple bookmarks without matching tags should not show any tag.");
  checkTagsSelector([TEST_TAG], []);

  // Add a tag to the second uri.
  PlacesUtils.tagging.tagURI(TEST_URI2, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI2)[0], TEST_TAG,
     "Correctly added a tag to the second bookmark.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == TEST_TAG,
    "Editing multiple bookmarks should show matching tags.");
  checkTagsSelector([TEST_TAG], [TEST_TAG]);

  // Remove tag from the first bookmark.
  PlacesUtils.tagging.untagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], undefined,
     "Correctly removed tag from the first bookmark.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple bookmarks without matching tags should not show any tag.");
  checkTagsSelector([TEST_TAG], []);

  // Remove tag from the second bookmark.
  PlacesUtils.tagging.untagURI(TEST_URI2, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI2)[0], undefined,
     "Correctly removed tag from the second bookmark.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple bookmarks without matching tags should not show any tag.");
  checkTagsSelector([], []);

  // Init panel with a nsIURI entry.
  gEditItemOverlay.initPanel({ uris: [TEST_URI] });

  // Add a tag.
  PlacesUtils.tagging.tagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], TEST_TAG,
     "Correctly added tag to the first entry.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == TEST_TAG,
    "Editing a single nsIURI entry shows the added tag.");
  checkTagsSelector([TEST_TAG], [TEST_TAG]);

  // Remove tag.
  PlacesUtils.tagging.untagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], undefined,
     "Correctly removed tag from the nsIURI entry.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing a single nsIURI entry should not show any tag.");
  checkTagsSelector([], []);

  // Init panel with multiple nsIURI entries.
  gEditItemOverlay.initPanel({ uris: [TEST_URI, TEST_URI2] });

  // Add a tag to the first entry.
  PlacesUtils.tagging.tagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], TEST_TAG,
     "Tag correctly added.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple nsIURIs without matching tags should not show any tag.");
  checkTagsSelector([TEST_TAG], []);

  // Add a tag to the second entry.
  PlacesUtils.tagging.tagURI(TEST_URI2, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI2)[0], TEST_TAG,
     "Tag correctly added.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == TEST_TAG,
    "Editing multiple nsIURIs should show matching tags.");
  checkTagsSelector([TEST_TAG], [TEST_TAG]);

  // Remove tag from the first entry.
  PlacesUtils.tagging.untagURI(TEST_URI, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI)[0], undefined,
     "Correctly removed tag from the first entry.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple nsIURIs without matching tags should not show any tag.");
  checkTagsSelector([TEST_TAG], []);

  // Remove tag from the second entry.
  PlacesUtils.tagging.untagURI(TEST_URI2, [TEST_TAG]);
  is(PlacesUtils.tagging.getTagsForURI(TEST_URI2)[0], undefined,
     "Correctly removed tag from the second entry.");
  await BrowserTestUtils.waitForCondition(
    () => document.getElementById("editBMPanel_tagsField").value == "",
    "Editing multiple nsIURIs without matching tags should not show any tag.");
  checkTagsSelector([], []);

  // Cleanup.
  await PlacesUtils.bookmarks.remove(bm.guid);
  await PlacesUtils.bookmarks.remove(bm2.guid);
});
