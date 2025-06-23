// debugBunjangApi.js
const bunjangService = require('./src/services/bunjangService');

async function debugBunjangApi() {
  const pid = '332047857';
  try {
    const product = await bunjangService.getBunjangProductDetails(pid);
    console.log('전체 API 응답:');
    console.log(JSON.stringify(product, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
  process.exit(0);
}

debugBunjangApi();