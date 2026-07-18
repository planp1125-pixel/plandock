# Docklite Usage Guide

## Dynamic Sequence Variables (Templates)

Docklite supports real-time dynamic variables inside your sequences. These variables are evaluated at the exact millisecond they are sent out to the physical port (Serial, TCP, or SSH), ensuring perfect accuracy even when used with delayed reaction rules.

You can insert these tags directly into your Sequence Editor text.

### 1. Auto-Incrementing Counters
To create a counter that increments every time the sequence is sent and resets when it reaches a maximum value, use the `{{COUNT}}` tag.

*   **Syntax:** `{{COUNT:min:max}}`
*   **Example:** `{{COUNT:1:40}}`
*   **Behavior:** The first time the sequence is sent, it will output `1`. The second time, `2`. It will continue incrementing until it reaches `40`, after which it will automatically loop back to `1`.

### 2. Standard Date & Time
To inject the current timestamp into your data, use the standard time tags.

*   `{{TIME}}` ➔ Outputs the current time in 24-hour format (e.g., `20:34:58`).
*   `{{DATE}}` ➔ Outputs the current date (e.g., `30/04/2026`).
*   `{{DATETIME}}` ➔ Outputs both separated by a space (e.g., `30/04/2026 20:34:58`).

### 3. Custom Date & Time Formats
If your hardware requires a specific time format, you can append standard formatting specifiers to the tags by adding a colon (`:`).

*   **Syntax:** `{{TIME:format}}` or `{{DATE:format}}` or `{{DATETIME:format}}`

**Common Format Specifiers:**
*   `%H` - Hour in 24h format (00-23)
*   `%I` - Hour in 12h format (01-12)
*   `%M` - Minute (00-59)
*   `%S` - Second (00-60)
*   `%p` - AM/PM marker
*   `%Y` - Year with century (e.g., 2026)
*   `%y` - Year without century (e.g., 26)
*   `%m` - Month number (01-12)
*   `%b` - Abbreviated month name (Jan, Feb)
*   `%d` - Day of the month (01-31)

**Custom Formatting Examples:**
*   `{{TIME:%I:%M %p}}` ➔ `08:34 PM`
*   `{{TIME:%H-%M-%S}}` ➔ `20-34-58`
*   `{{DATE:%Y/%m/%d}}` ➔ `2026/04/30`
*   `{{DATE:%d %b %Y}}` ➔ `30 Apr 2026`
*   `{{DATETIME:%Y-%m-%d %H:%M:%S}}` ➔ `2026-04-30 20:34:58`

### Example Usage in a Real Sequence
If you are sending a pH Analysis Report and want to automatically stamp the date, time, and sequence number, your Sequence Editor text (in ASCII mode) should look like this:

```
<CR><LF>
************************      pH Analysis Report       ************************<CR><LF>
Instrument Sr. No.  : A         <HT><HT><HT>{{TIME:%H:%M:%S}}    {{DATE:%d/%m/%Y}}<CR><LF>
³  {{COUNT:1:40}}  *            *                           + 5.347  @25   + 95.9    21.5  ³<CR><LF>
```
