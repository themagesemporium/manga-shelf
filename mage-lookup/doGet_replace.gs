// In Code.gs, REPLACE the old doGet() function with this one.
// Your Mage Scanner link keeps working; add ?page=tools to the end of it for Mage Tools.
function doGet(e) {
  const tools = e && e.parameter && e.parameter.page === 'tools';
  return HtmlService.createHtmlOutputFromFile(tools ? 'Tools' : 'Scanner')
    .setTitle(tools ? 'Mage Tools' : 'Mage Scanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
