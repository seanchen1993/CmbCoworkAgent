package com.devclaw.botcontrol.application;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;

/** Internal dates only. Never Jackson's bean projection or local timezone. */
public final class RequirementInstantSerializer extends JsonSerializer<Instant> {
    private static final DateTimeFormatter UTC_MILLIS=new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
    @Override public void serialize(Instant value,JsonGenerator out,SerializerProvider provider)throws IOException{
        out.writeString(UTC_MILLIS.format(value));
    }
}
