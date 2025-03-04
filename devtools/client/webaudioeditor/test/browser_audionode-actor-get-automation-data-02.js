/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Test AudioNode#addAutomationEvent() when automation series ends with
 * `setTargetAtTime`, which approaches its target to infinity.
 */

add_task(async function() {
  const { target, front } = await initBackend(SIMPLE_CONTEXT_URL);
  const [_, [destNode, oscNode, gainNode]] = await Promise.all([
    front.setup({ reload: true }),
    get3(front, "create-node")
  ]);

  await oscNode.addAutomationEvent("frequency", "setValueAtTime", [300, 0.1]);
  await oscNode.addAutomationEvent("frequency", "linearRampToValueAtTime", [500, 0.4]);
  await oscNode.addAutomationEvent("frequency", "exponentialRampToValueAtTime", [200, 0.6]);
  // End with a setTargetAtTime event, as the target approaches infinity, which will
  // give us more points to render than the default 2000
  await oscNode.addAutomationEvent("frequency", "setTargetAtTime", [1000, 2, 0.5]);

  var { events, values } = await oscNode.getAutomationData("frequency");

  is(events.length, 4, "4 recorded events returned.");
  is(values.length, 4000, "4000 value points returned when ending with exponentiall approaching automator.");

  checkAutomationValue(values, 2.01, 215.055);
  checkAutomationValue(values, 2.1, 345.930);
  checkAutomationValue(values, 3, 891.601);
  checkAutomationValue(values, 5, 998.01);

  // Refetch the automation data to ensure it recalculates correctly (bug 1118071)
  var { events, values } = await oscNode.getAutomationData("frequency");

  checkAutomationValue(values, 2.01, 215.055);
  checkAutomationValue(values, 2.1, 345.930);
  checkAutomationValue(values, 3, 891.601);
  checkAutomationValue(values, 5, 998.01);

  await removeTab(target.tab);
});
