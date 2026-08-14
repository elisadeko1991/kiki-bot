function getNextRunTime(hour, minute, timezone) {
  const now = new Date();

  const chicagoString = now.toLocaleString('en-US', { timeZone: timezone });
  const chicagoAsUtc = new Date(chicagoString);

  const offsetMs = now.getTime() - chicagoAsUtc.getTime();

  const targetWallClock = new Date(
    chicagoAsUtc.getFullYear(),
    chicagoAsUtc.getMonth(),
    chicagoAsUtc.getDate(),
    hour,
    minute,
    0
  );

  let targetReal = new Date(targetWallClock.getTime() + offsetMs);

  if (targetReal.getTime() <= now.getTime()) {
    targetReal = new Date(targetReal.getTime() + 24 * 60 * 60 * 1000);
  }

  return targetReal;
}

function scheduleDaily(hour, minute, timezone, callback) {
  function scheduleNext() {
    const nextRun = getNextRunTime(hour, minute, timezone);
    const delayMs = nextRun.getTime() - Date.now();

    console.log('[scheduler] Next run at ' + nextRun.toISOString() + ' (in ' + Math.round(delayMs / 60000) + ' minutes)');

    setTimeout(async () => {
      try {
        await callback();
      } catch (err) {
        console.error('[scheduler] Callback error:', err.message);
      }
      scheduleNext();
    }, delayMs);
  }

  scheduleNext();
}

module.exports = { scheduleDaily: scheduleDaily, getNextRunTime: getNextRunTime };
