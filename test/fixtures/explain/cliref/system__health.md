# health

> Hardware health monitoring on x86 (i386) based devices. Use /system/health/print to read the sensor values.

-----------

## system/health 
**Conditions:** i386
**Type:** Settings Directory

Hardware health monitoring on x86 (i386) based devices. Use `/system/health/print` to read the sensor values.

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="state-after-reboot" typ="enum (disabled | enabled)">Enables or disables hardware health monitoring after a reboot.</ArgTableRow>
</ArgTable>

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="core" typ="num">CPU core voltage.</ArgTableRow>
<ArgTableRow arg="3.3v" typ="num">3.3 V supply line voltage.</ArgTableRow>
<ArgTableRow arg="5v" typ="num">5 V supply line voltage.</ArgTableRow>
<ArgTableRow arg="12v" typ="num">12 V supply line voltage.</ArgTableRow>
<ArgTableRow arg="lm87-temp" typ="num">Temperature measured by the LM87 sensor.</ArgTableRow>
<ArgTableRow arg="cpu-temp" typ="num">CPU temperature.</ArgTableRow>
<ArgTableRow arg="board-temp" typ="num">Board temperature.</ArgTableRow>
<ArgTableRow arg="voltage1" typ="num">Voltage measured by sensor 1.</ArgTableRow>
<ArgTableRow arg="voltage2" typ="num">Voltage measured by sensor 2.</ArgTableRow>
<ArgTableRow arg="voltage3" typ="num">Voltage measured by sensor 3.</ArgTableRow>
<ArgTableRow arg="voltage4" typ="num">Voltage measured by sensor 4.</ArgTableRow>
<ArgTableRow arg="voltage5" typ="num">Voltage measured by sensor 5.</ArgTableRow>
<ArgTableRow arg="voltage6" typ="num">Voltage measured by sensor 6.</ArgTableRow>
<ArgTableRow arg="voltage7" typ="num">Voltage measured by sensor 7.</ArgTableRow>
<ArgTableRow arg="voltage8" typ="num">Voltage measured by sensor 8.</ArgTableRow>
<ArgTableRow arg="voltage9" typ="num">Voltage measured by sensor 9.</ArgTableRow>
<ArgTableRow arg="voltage10" typ="num">Voltage measured by sensor 10.</ArgTableRow>
<ArgTableRow arg="temp1" typ="num">Temperature measured by sensor 1.</ArgTableRow>
<ArgTableRow arg="temp2" typ="num">Temperature measured by sensor 2.</ArgTableRow>
<ArgTableRow arg="temp3" typ="num">Temperature measured by sensor 3.</ArgTableRow>
<ArgTableRow arg="fan1" typ="num">Speed of fan 1 in RPM.</ArgTableRow>
<ArgTableRow arg="fan2" typ="num">Speed of fan 2 in RPM.</ArgTableRow>
<ArgTableRow arg="fan3" typ="num">Speed of fan 3 in RPM.</ArgTableRow>
<ArgTableRow arg="state" typ="enum (disabled | enabled)">Health monitoring state.</ArgTableRow>
</ArgTable>

## system/health 
**Conditions:** !i386
**Syscap:** health
**Type:** Directory

Hardware health monitoring on non-x86 devices. Use `/system/health/print` to list the name, current value and type of each monitored parameter.

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="name" typ="string">Name of the monitored parameter, for example `voltage`, `cpu-temperature` or `fan1-speed`.</ArgTableRow>
<ArgTableRow arg="value" typ="alt { valuet: num
, valuer: num
, valuev: num
, valuea: num
, valuew: num
, valueb: enum (ok | fail | not-present | idle | no-input) { ok:0, fail:1, not-present:2, idle:3, no-input:4 }
, values: string
 }">Current value of the parameter. The value and its unit depend on the parameter `type`.</ArgTableRow>
<ArgTableRow arg="type" typ="enum (C | RPM | V | A | W |  | )">Type of the measured value: `C` is degrees Celsius, `RPM` is fan speed, `V` is voltage, `A` is current and `W` is power consumption.</ArgTableRow>
</ArgTable>
