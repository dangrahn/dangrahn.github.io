// Router for the AI Competence Development Apps Script project.
// Dispatches incoming requests to the appropriate handler based on action.

function doGet(e) {
  return handleAvailability(e)
}

function doPost(e) {
  var body
  try {
    body = JSON.parse(e.postData.contents)
  } catch (_) {
    return jsonResponse({ error: 'invalid_input', message: 'Request body must be valid JSON.' })
  }

  if (body.action === 'assess') return handleAssessment(body)
  return handleBooking(body)
}
