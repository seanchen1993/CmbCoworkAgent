package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.ApplicationResponse;
import java.io.IOException;
import javax.servlet.http.HttpServletResponse;

final class HttpOutput {
    static void write(HttpServletResponse response, ApplicationResponse result) throws IOException {
        byte[] bytes = result.body();
        response.setStatus(result.status); response.setContentType("application/json");
        response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
        response.setContentLength(bytes.length); response.getOutputStream().write(bytes);
    }
}
