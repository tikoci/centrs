# partitions

> -----------

import {ArgTableRow} from '@site/src/components/common';
import {ArgTable} from '@site/src/components/common';

-----------

# partitions

**Conditions:** !i386, !smips, !mmips
**Syscap:** partitions
**Type:** Directory

<ArgTable c1="Flag" c2="Name" c3="Description">
<ArgTableRow arg="A" typ="active">active</ArgTableRow>
<ArgTableRow arg="R" typ="running">running</ArgTableRow>
</ArgTable>

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="name" typ="string"></ArgTableRow>
<ArgTableRow arg="fallback-to" typ="enum (etherboot | next)"></ArgTableRow>
</ArgTable>

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="version" typ="string"></ArgTableRow>
<ArgTableRow arg="size" typ="num"></ArgTableRow>
</ArgTable>

## partitions/activate

**Conditions:** !i386, !smips, !mmips
**Type:** Command

## partitions/copy-to

**Conditions:** !i386, !smips, !mmips
**Type:** Command

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="status" typ="string"></ArgTableRow>
</ArgTable>

## partitions/repartition

**Conditions:** !i386, !smips, !mmips
**Type:** Command

<ArgTable c1="Argument" c2="Type" c3="Description">
<ArgTableRow arg="partitions" typ="num"></ArgTableRow>
</ArgTable>

## partitions/restore-config-from

**Conditions:** !i386, !smips, !mmips
**Type:** Command

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="status" typ="string"></ArgTableRow>
</ArgTable>

## partitions/save-config-to

**Conditions:** !i386, !smips, !mmips
**Type:** Command

<ArgTable c1="Read-only Argument" c2="Type" c3="Description">
<ArgTableRow arg="status" typ="string"></ArgTableRow>
</ArgTable>
